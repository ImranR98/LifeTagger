import { Component, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService } from '../services/api.service';

@Component({
  selector: 'app-file',
  templateUrl: './file.component.html',
  styleUrls: ['./file.component.scss']
})
export class FileComponent implements OnInit {

  constructor(private apiService: ApiService, private route: ActivatedRoute, private router: Router) { }

  file: { file: string, existingTags: string[] } | null = null
  allTags: string[] = []

  async ngOnInit() {
    try {
      let f = this.route.snapshot.paramMap.get('file')
      if (!f) this.router.navigate(['/files'])
      else {
        this.allTags = await this.apiService.getTags()
        this.file = await this.apiService.getFileInfo(f)
      }
    } catch (err) {
      console.error(err)
    }
  }

}
